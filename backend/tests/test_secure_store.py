"""Encryption at rest: plaintext DB + legacy transcript files are migrated into SQLCipher (temp dir, test key)."""
import os, sqlite3, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
tmp = tempfile.mkdtemp()
os.chdir(tmp)   # database.py uses a cwd-relative path
os.environ["ELOQUENT_DB_KEY"] = "ab" * 32
os.environ["ELOQUENT_STATE_DIR"] = tmp

from sqlalchemy import create_engine

import secure_store
import database
from database import Base, Meeting, Transcript, LegacyTranscriptFile, SessionLocal

# An older, plaintext database with a row still sitting in its WAL, and a legacy transcript file.
plain = create_engine(f"sqlite:///{database.DB_PATH}")
Base.metadata.create_all(plain)
plain.dispose()
legacy_dir = os.path.join(tmp, "transcripts")
os.mkdir(legacy_dir)
with open(os.path.join(legacy_dir, "Meeting_1.txt"), "w") as f:
    f.write("Me: the secret launch date is March 3\n")
with open(os.path.join(legacy_dir, "Orphan.txt"), "w") as f:
    f.write("no meeting points here")
c = sqlite3.connect(database.DB_PATH)
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("INSERT INTO meetings (id, title, transcript_filepath) VALUES (1, 'Launch', '/Users/old/backend/transcripts/Meeting_1.txt')")
c.execute("INSERT INTO transcripts (meeting_id, speaker, text) VALUES (1, 'Me', 'confidential words')")
c.commit()
c.close()

assert secure_store.encrypt_existing_database(database.DB_PATH)
assert not secure_store.is_plaintext(database.DB_PATH)
assert not os.path.exists(database.DB_PATH + ".plaintext")
assert b"confidential" not in open(database.DB_PATH, "rb").read()
try:
    sqlite3.connect(database.DB_PATH).execute("SELECT * FROM meetings").fetchall()
    raise AssertionError("plain sqlite3 read the encrypted database")
except sqlite3.DatabaseError:
    pass
assert not secure_store.encrypt_existing_database(database.DB_PATH)   # idempotent

assert database.import_legacy_files(legacy_dir) == 2
assert not os.path.exists(legacy_dir)
db = SessionLocal()
assert db.query(Transcript).one().text == "confidential words"
m = db.query(Meeting).one()
assert m.transcript_filepath is None
files = {f.filename: f for f in db.query(LegacyTranscriptFile).all()}
assert files["Meeting_1.txt"].meeting_id == 1 and b"March 3" in files["Meeting_1.txt"].content
assert files["Orphan.txt"].meeting_id is None
db.close()
database.engine.dispose()
assert b"March 3" not in open(database.DB_PATH, "rb").read()

# A wrong key can't open it, and a missing key is never silently replaced by a new one.
secure_store.database_key.cache_clear()
os.environ["ELOQUENT_DB_KEY"] = "cd" * 32
try:
    secure_store.verify(database.DB_PATH, secure_store.database_key(database.DB_PATH))
    opened = True
except Exception:  # noqa: BLE001 - SQLCipher reports a bad key as "not a database" or failed HMACs
    opened = False
assert not opened, "wrong key opened the database"
secure_store.database_key.cache_clear()
del os.environ["ELOQUENT_DB_KEY"]
secure_store._keyring_get = lambda: None
try:
    secure_store.database_key(database.DB_PATH)
    raise AssertionError("created a new key for an encrypted database")
except secure_store.KeyUnavailable:
    pass

print("secure store tests passed")
