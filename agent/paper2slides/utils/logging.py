"""
Logging utilities
"""
import logging

logger = logging.getLogger(__name__)


def setup_logging(level: int = logging.INFO):
    """Configure logging with console output."""
    logging.basicConfig(
        level=level,
        format='%(asctime)s [%(levelname)s] %(message)s',
        datefmt='%H:%M:%S',
        force=True
    )


def log_section(title: str):
    """Log a section separator for better readability."""
    logger = logging.getLogger("paper2slides")
    logger.info("")
    logger.info(f"{'─' * 60}")
    logger.info(f"{title}")
    logger.info(f"{'─' * 60}")

