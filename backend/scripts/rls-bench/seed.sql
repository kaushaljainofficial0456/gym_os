-- 50 gyms x 200 members; history per member. Run as admin (bypasses RLS).
INSERT INTO organizations (id, name, slug, type, created_at)
  SELECT 'bg' || g, 'Bench Gym ' || g, 'bench-gym-' || g, 'gym', now()::text FROM generate_series(1,50) g;
INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
  SELECT 'bo' || g, 'bg' || g, 'bo' || g || '@bench.invalid', 'x', 'GYM_OWNER', 'Owner', 1, now()::text FROM generate_series(1,50) g;
INSERT INTO users (id, org_id, email, password_hash, role, name, active, created_at)
  SELECT 'bu' || g || '_' || m, 'bg' || g, 'bu' || g || '_' || m || '@bench.invalid', 'x', 'CLIENT', 'Member', 1, now()::text
    FROM generate_series(1,50) g, generate_series(1,200) m;
INSERT INTO clients (id, user_id, org_id, status, goal, created_at)
  SELECT 'bc' || g || '_' || m, 'bu' || g || '_' || m, 'bg' || g, 'ON_TRACK', 'GENERAL', now()::text
    FROM generate_series(1,50) g, generate_series(1,200) m;
INSERT INTO workouts (id, org_id, client_id, name, status, scheduled_date, created_at)
  SELECT 'bw' || g || '_' || m || '_' || w, 'bg' || g, 'bc' || g || '_' || m, 'Workout ' || w, 'completed',
         (date '2026-11-15' - w)::text, now()::text
    FROM generate_series(1,50) g, generate_series(1,200) m, generate_series(1,20) w;
INSERT INTO weight_logs (id, client_id, date, weight, created_at)
  SELECT 'bwl' || g || '_' || m || '_' || d, 'bc' || g || '_' || m, (date '2026-11-15' - d)::text, 70 + random() * 10, now()::text
    FROM generate_series(1,50) g, generate_series(1,200) m, generate_series(1,30) d;
INSERT INTO payments (id, org_id, client_id, amount, paid_at)
  SELECT 'bp' || g || '_' || m || '_' || p, 'bg' || g, 'bc' || g || '_' || m, 1500, (date '2026-11-15' - p * 30)::text
    FROM generate_series(1,50) g, generate_series(1,200) m, generate_series(1,6) p;
INSERT INTO attendance (id, org_id, client_id, date)
  SELECT 'ba' || g || '_' || m || '_' || d, 'bg' || g, 'bc' || g || '_' || m, (date '2026-11-15' - d)::text
    FROM generate_series(1,50) g, generate_series(1,200) m, generate_series(1,20) d;
ANALYZE;
