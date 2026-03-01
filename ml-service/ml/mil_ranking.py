from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Tuple

import torch
from torch import nn


@dataclass(frozen=True)
class MilRankingConfig:
    margin: float = 1.0
    topk_ratio: float = 0.1
    lambda_sparsity: float = 8e-5
    lambda_smoothness: float = 8e-5


class MilRankingHead(nn.Module):
    """
    Lightweight segment scorer (per-clip anomaly score in [0,1]).

    Inspired by: "Real-world Anomaly Detection in Surveillance Videos" (CVPR 2018),
    where a small network scores segments and is trained with a MIL ranking loss.
    """

    def __init__(self, in_dim: int = 4096, hidden_dim: int = 256, dropout: float = 0.6):
        super().__init__()
        self.in_dim = int(in_dim)
        self.hidden_dim = int(hidden_dim)
        self.dropout = float(dropout)

        self.net = nn.Sequential(
            nn.Linear(self.in_dim, self.hidden_dim),
            nn.ReLU(inplace=True),
            nn.Dropout(p=self.dropout),
            nn.Linear(self.hidden_dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        logits = self.net(x).squeeze(-1)
        return torch.sigmoid(logits)


def _topk_mean(scores: torch.Tensor, topk_ratio: float) -> torch.Tensor:
    if scores.numel() == 0:
        return torch.zeros((), device=scores.device, dtype=scores.dtype)
    k = max(1, int(round(float(topk_ratio) * float(scores.numel()))))
    topk, _idx = torch.topk(scores, k=k, largest=True, sorted=False)
    return topk.mean()


def mil_ranking_loss(
    scores_abnormal: torch.Tensor,
    scores_normal: torch.Tensor,
    cfg: MilRankingConfig,
) -> Tuple[torch.Tensor, Dict[str, float]]:
    """
    Hinge MIL ranking loss with sparsity + temporal smoothness regularizers.
    """
    abn = scores_abnormal.flatten()
    nor = scores_normal.flatten()

    abn_topk = _topk_mean(abn, cfg.topk_ratio)
    nor_topk = _topk_mean(nor, cfg.topk_ratio)

    ranking = torch.relu(float(cfg.margin) - (abn_topk - nor_topk))
    sparsity = abn.mean() if abn.numel() > 0 else torch.zeros_like(ranking)

    if abn.numel() >= 2:
        smoothness = torch.mean((abn[1:] - abn[:-1]) ** 2)
    else:
        smoothness = torch.zeros_like(ranking)

    total = ranking + float(cfg.lambda_sparsity) * sparsity + float(cfg.lambda_smoothness) * smoothness
    metrics = {
        "loss_total": float(total.detach().cpu().item()),
        "loss_ranking": float(ranking.detach().cpu().item()),
        "loss_sparsity": float(sparsity.detach().cpu().item()),
        "loss_smoothness": float(smoothness.detach().cpu().item()),
        "abn_topk": float(abn_topk.detach().cpu().item()),
        "nor_topk": float(nor_topk.detach().cpu().item()),
    }
    return total, metrics


def save_mil_head(checkpoint_path: str | Path, head: MilRankingHead, meta: Dict[str, Any]) -> None:
    path = Path(checkpoint_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "head_state": head.state_dict(),
            "in_dim": int(head.in_dim),
            "hidden_dim": int(head.hidden_dim),
            "dropout": float(head.dropout),
            "meta": dict(meta),
        },
        path,
    )


def load_mil_head(checkpoint_path: str | Path, device: torch.device) -> Tuple[MilRankingHead, Dict[str, Any]]:
    ckpt = torch.load(Path(checkpoint_path), map_location=device)
    in_dim = int(ckpt.get("in_dim", 4096))
    hidden_dim = int(ckpt.get("hidden_dim", 256))
    dropout = float(ckpt.get("dropout", 0.6))
    head = MilRankingHead(in_dim=in_dim, hidden_dim=hidden_dim, dropout=dropout)
    head.load_state_dict(ckpt["head_state"])
    head.to(device)
    head.eval()
    meta = ckpt.get("meta", {})
    return head, meta if isinstance(meta, dict) else {}

