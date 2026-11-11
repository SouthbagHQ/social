# Offline SQLite preservation test. No live accounts or services.
import sqlite3, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
c = sqlite3.connect(':memory:')
c.executescript("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('seller'),('buyer');")
c.executescript((root/'migrations/0010_marketplace.sql').read_text())
c.execute("INSERT INTO marketplace_listings(id,seller_id,title,price,category,condition,location,pickup,postage,created_at,updated_at) VALUES('l','seller','Desk',100,'furniture','good','Canberra',1,0,1,1)")
for n, status in enumerate(['pending','accepted','declined','withdrawn']):
 c.execute("INSERT INTO marketplace_offers VALUES(?,?,?,?,?,?,?,?)", (str(n),'l','buyer',n*100,'Untouched message',status,1,None if n==0 else 2))
before = c.execute('SELECT * FROM marketplace_offers ORDER BY id').fetchall()
c.commit()
c.executescript('BEGIN;'+(root/'migrations/0020_signed_marketplace_offers.sql').read_text()+'COMMIT;')
assert before == c.execute('SELECT * FROM marketplace_offers ORDER BY id').fetchall()
assert len(c.execute('PRAGMA foreign_key_list(marketplace_offers)').fetchall()) == 2
assert {'marketplace_offers_listing','marketplace_offers_buyer'} <= {r[1] for r in c.execute('PRAGMA index_list(marketplace_offers)')}
c.execute("INSERT INTO marketplace_offers VALUES('negative','l','buyer',-1250,'Take it','pending',3,NULL)")
assert c.execute('PRAGMA foreign_key_check').fetchall() == []
print('Migration preserves every column, all statuses, nulls, both indexes and foreign keys; negative insert passes.')
