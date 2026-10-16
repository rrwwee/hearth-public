"""Runtime environment for fixtures that own their installation and Git data."""
import os


def fixture_environment(**settings):
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("HEARTH_", "GIT_")) and key != "PORT"}
    environment.update(settings)
    return environment
