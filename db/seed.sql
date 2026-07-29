INSERT INTO maps (id, name, description) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Demo: Airport Trip', 'Shows groupings, locks, ephemeral links and notes.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO groups (id, map_id, name, color, notes) VALUES
  ('99999999-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','The Hotel','#7aa7d8','Everything inside the hotel building.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO locations (id, map_id, group_id, name, kind, layer, notes, visited, x, y) VALUES
 ('aaaaaaa1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','Hotel Lobby','round-rectangle','Ground','Start here. The front desk holds the luggage.',true,   0,   0),
 ('aaaaaaa1-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','99999999-0000-0000-0000-000000000001','Hotel Room 214','round-rectangle','Floor 2','The ephemeral link models the elevator.',false, 250, -150),
 ('aaaaaaa1-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',NULL,'Rental Car Desk','diamond','Ground','You must pick up the keys before you can drive.',false, 560, 150),
 ('aaaaaaa1-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',NULL,'Parking Garage','hexagon','Underground','Level -1, spot C14.',false, 900, 150),
 ('aaaaaaa1-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111',NULL,'Airport Terminal B','star','City','Forty minute drive.',false, 1240, 60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO connections
  (id, map_id, source_id, target_id, name, notes, travel_kind, arrow_source, arrow_target, ephemeral, locked, lock_note, weight)
VALUES
 ('ccccccc1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aaaaaaa1-0000-0000-0000-000000000001','aaaaaaa1-0000-0000-0000-000000000002','Elevator','Key cards only work for your own floor.','dotted',true, true, true,false,'',1),
 ('ccccccc1-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','aaaaaaa1-0000-0000-0000-000000000001','aaaaaaa1-0000-0000-0000-000000000003','Walk Out The Main Doors','','solid',true,true,false,false,'',1),
 ('ccccccc1-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','aaaaaaa1-0000-0000-0000-000000000003','aaaaaaa1-0000-0000-0000-000000000004','Take The Keys To The Garage','','solid',false,true,false,true,'Needs the rental agreement signed.',2),
 ('ccccccc1-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','aaaaaaa1-0000-0000-0000-000000000004','aaaaaaa1-0000-0000-0000-000000000005','Highway 9 Southbound','Tolls: $4.','solid',false,true,false,true,'Requires the car.',12)
ON CONFLICT (id) DO NOTHING;

INSERT INTO connection_requirements (connection_id, location_id) VALUES
 ('ccccccc1-0000-0000-0000-000000000003','aaaaaaa1-0000-0000-0000-000000000003'),
 ('ccccccc1-0000-0000-0000-000000000004','aaaaaaa1-0000-0000-0000-000000000004')
ON CONFLICT DO NOTHING;
