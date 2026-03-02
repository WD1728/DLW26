#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path
from typing import Dict

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from ml.c3d_data import Crowd11ClipDataset
from ml.c3d_paper import C3DPaper


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train paper-style 3D ConvNet on Crowd-11 formatted splits."
    )
    parser.add_argument("--data-root", required=True, help="Dataset root containing train/val class folders")
    parser.add_argument("--train-split", default="train")
    parser.add_argument("--val-split", default="val")
    parser.add_argument("--out-dir", default=str(PROJECT_ROOT / "models" / "paper_c3d"))

    parser.add_argument("--temporal-depth", type=int, default=3, choices=[1, 3, 5, 7])
    parser.add_argument("--clip-len", type=int, default=16)
    parser.add_argument("--epochs", type=int, default=14)
    parser.add_argument("--batch-size", type=int, default=30)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--max-clips-per-video", type=int, default=0)

    parser.add_argument("--lr", type=float, default=0.003)
    parser.add_argument("--lr-step", type=int, default=4)
    parser.add_argument("--lr-gamma", type=float, default=0.1)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--log-every", type=int, default=100, help="Print batch progress every N steps (0=off)")
    return parser.parse_args()


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def accuracy(logits: torch.Tensor, labels: torch.Tensor) -> float:
    preds = torch.argmax(logits, dim=1)
    return float((preds == labels).float().mean().item())


def run_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    optimizer: torch.optim.Optimizer | None,
    device: torch.device,
    epoch: int,
    split: str,
    log_every: int,
) -> Dict[str, float]:
    train_mode = optimizer is not None
    model.train(train_mode)

    loss_sum = 0.0
    acc_sum = 0.0
    count = 0

    total_steps = max(1, len(loader))
    for step, (clips, labels) in enumerate(loader, start=1):
        clips = clips.to(device, non_blocking=True)
        labels = labels.to(device, non_blocking=True)

        if optimizer is not None:
            optimizer.zero_grad(set_to_none=True)

        logits = model(clips)
        loss = criterion(logits, labels)

        if optimizer is not None:
            loss.backward()
            optimizer.step()

        bsz = int(labels.shape[0])
        loss_sum += float(loss.item()) * bsz
        acc_sum += accuracy(logits.detach(), labels) * bsz
        count += bsz

        if log_every > 0 and (step % log_every == 0 or step == total_steps):
            running_loss = loss_sum / max(1, count)
            running_acc = acc_sum / max(1, count)
            print(
                json.dumps(
                    {
                        "epoch": int(epoch),
                        "split": split,
                        "step": int(step),
                        "steps": int(total_steps),
                        "running_loss": float(running_loss),
                        "running_acc": float(running_acc),
                    }
                ),
                flush=True,
            )

    if count <= 0:
        return {"loss": 0.0, "acc": 0.0}
    return {"loss": loss_sum / count, "acc": acc_sum / count}


def main() -> None:
    args = parse_args()
    set_seed(args.seed)

    device = torch.device(args.device)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data_root = Path(args.data_root)
    train_dir = data_root / args.train_split
    val_dir = data_root / args.val_split
    if not train_dir.exists() or not val_dir.exists():
        raise FileNotFoundError(
            f"Expected train/val splits under {data_root}. Missing: train={train_dir.exists()} val={val_dir.exists()}"
        )

    train_ds = Crowd11ClipDataset(
        split_dir=train_dir,
        clip_len=args.clip_len,
        train=True,
        max_clips_per_video=args.max_clips_per_video,
        seed=args.seed,
    )
    class_to_idx = train_ds.class_to_idx
    val_ds = Crowd11ClipDataset(
        split_dir=val_dir,
        class_to_idx=class_to_idx,
        clip_len=args.clip_len,
        train=False,
        max_clips_per_video=args.max_clips_per_video,
        seed=args.seed,
    )

    train_loader = DataLoader(
        train_ds,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=args.num_workers,
        pin_memory=False,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.num_workers,
        pin_memory=False,
    )

    model = C3DPaper(num_classes=len(class_to_idx), temporal_depth=args.temporal_depth)
    model.to(device)

    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.SGD(
        model.parameters(),
        lr=args.lr,
        momentum=0.9,
        weight_decay=args.weight_decay,
    )
    scheduler = torch.optim.lr_scheduler.StepLR(
        optimizer,
        step_size=max(1, args.lr_step),
        gamma=args.lr_gamma,
    )

    history = []
    best_val_acc = -1.0
    best_path = out_dir / f"c3d_depth{args.temporal_depth}_best.pt"
    latest_path = out_dir / f"c3d_depth{args.temporal_depth}_latest.pt"

    for epoch in range(1, args.epochs + 1):
        train_metrics = run_epoch(
            model=model,
            loader=train_loader,
            criterion=criterion,
            optimizer=optimizer,
            device=device,
            epoch=epoch,
            split="train",
            log_every=int(args.log_every),
        )
        val_metrics = run_epoch(
            model=model,
            loader=val_loader,
            criterion=criterion,
            optimizer=None,
            device=device,
            epoch=epoch,
            split="val",
            log_every=int(args.log_every),
        )
        scheduler.step()

        row = {
            "epoch": epoch,
            "lr": float(optimizer.param_groups[0]["lr"]),
            "train_loss": train_metrics["loss"],
            "train_acc": train_metrics["acc"],
            "val_loss": val_metrics["loss"],
            "val_acc": val_metrics["acc"],
        }
        history.append(row)
        print(json.dumps(row))

        state = {
            "model_state": model.state_dict(),
            "class_to_idx": class_to_idx,
            "epoch": epoch,
            "temporal_depth": args.temporal_depth,
            "clip_len": args.clip_len,
        }
        torch.save(state, latest_path)
        if val_metrics["acc"] > best_val_acc:
            best_val_acc = val_metrics["acc"]
            torch.save(state, best_path)

    meta = {
        "data_root": str(data_root),
        "train_split": args.train_split,
        "val_split": args.val_split,
        "num_train_clips": len(train_ds),
        "num_val_clips": len(val_ds),
        "num_classes": len(class_to_idx),
        "class_to_idx": class_to_idx,
        "temporal_depth": args.temporal_depth,
        "clip_len": args.clip_len,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "best_val_acc": float(best_val_acc),
        "history": history,
    }
    with (out_dir / "train_meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(f"Saved best checkpoint: {best_path}")
    print(f"Saved latest checkpoint: {latest_path}")
    print(f"Best val acc: {best_val_acc:.4f}")


if __name__ == "__main__":
    main()
