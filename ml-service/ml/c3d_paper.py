from __future__ import annotations

from typing import Tuple

import torch
import torch.nn as nn


def _kernel_3d(temporal_depth: int) -> Tuple[int, int, int]:
    d = int(max(1, temporal_depth))
    return (d, 3, 3)


def _pad_3d(temporal_depth: int) -> Tuple[int, int, int]:
    d = int(max(1, temporal_depth))
    return (d // 2, 1, 1)


class C3DPaper(nn.Module):
    """
    C3D-style architecture following the paper setup:
    - Input clip: [B, 3, 16, 112, 112]
    - 8 conv layers + 5 maxpool layers
    - 2 FC layers (4096 each) + classifier
    """

    def __init__(
        self,
        num_classes: int = 11,
        temporal_depth: int = 3,
        dropout_p: float = 0.5,
    ) -> None:
        super().__init__()
        k = _kernel_3d(temporal_depth)
        p = _pad_3d(temporal_depth)

        self.features = nn.Sequential(
            nn.Conv3d(3, 64, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.MaxPool3d(kernel_size=(1, 2, 2), stride=(1, 2, 2)),
            nn.Conv3d(64, 128, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.MaxPool3d(kernel_size=(2, 2, 2), stride=(2, 2, 2)),
            nn.Conv3d(128, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.Conv3d(256, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.MaxPool3d(kernel_size=(2, 2, 2), stride=(2, 2, 2)),
            nn.Conv3d(256, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.Conv3d(256, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.MaxPool3d(kernel_size=(2, 2, 2), stride=(2, 2, 2)),
            nn.Conv3d(256, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.Conv3d(256, 256, kernel_size=k, padding=p),
            nn.ReLU(inplace=True),
            nn.MaxPool3d(kernel_size=(2, 2, 2), stride=(2, 2, 2)),
        )

        # For input [3,16,112,112], output is [256,1,3,3] => 2304
        self.fc6 = nn.Linear(256 * 1 * 3 * 3, 4096)
        self.fc7 = nn.Linear(4096, 4096)
        self.classifier = nn.Linear(4096, int(num_classes))

        self.relu = nn.ReLU(inplace=True)
        self.drop = nn.Dropout(p=float(dropout_p))

    def extract_features(self, x: torch.Tensor) -> torch.Tensor:
        z = self.features(x)
        z = z.flatten(1)
        z = self.relu(self.fc6(z))
        z = self.drop(z)
        z = self.relu(self.fc7(z))
        z = self.drop(z)
        return z

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.extract_features(x)
        return self.classifier(z)
