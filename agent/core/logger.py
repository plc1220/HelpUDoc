import logging
import sys

def get_logger(name: str):
    """Initializes a logger with a default configuration."""
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    # Create a handler to print logs to stdout
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(logging.INFO)

    # Create a formatter and set it for the handler
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    handler.setFormatter(formatter)

    # Add the handler to the logger
    if not logger.handlers:
        logger.addHandler(handler)

    return logger

# Example of a default logger
log = get_logger(__name__)