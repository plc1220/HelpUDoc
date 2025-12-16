from enum import Enum
from dataclasses import dataclass


class SourceType(Enum):
    """Document source type."""
    PAPER = "paper"
    GENERAL = "general"


@dataclass
class SummaryConfig:
    """Configuration for summary processing."""
    source_type: SourceType = SourceType.PAPER
    clean_references: bool = True
