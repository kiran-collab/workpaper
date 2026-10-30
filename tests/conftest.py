"""Test settings, applied before the package is imported: a throwaway database and demo mode."""
import os
import sys
import tempfile
from pathlib import Path

os.environ['WP_DB'] = str(Path(tempfile.mkdtemp()) / 'journal.db')
os.environ['WP_DEMO'] = '1'
os.environ.pop('ANTHROPIC_API_KEY', None)  # unit tests never call the real API
sys.path.insert(0, str(Path(__file__).parent))  # tests/fakes.py
