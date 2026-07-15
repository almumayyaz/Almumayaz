// k6 load test for المُميز (Al-Mumayaz) platform
// Docs: https://k6.io/docs/
//
// WHY THIS EXISTS
// ----------------
// The capacity report is built from static code analysis (measured payload
// sizes + counted Firebase reads/writes per route). These scenarios let you
// CONFIRM the projections against the real deployment instead of trusting the
// model. Run them against a STAGING deployment with realistic seed data
// (e.g. 1k / 10k / 50k users in Firebase) — the whole-collection read pattern
// means results change dramatically with the number of accounts stored.
//
// INSTALL k6:   https://k6.io/docs/get-started/installation/
//
// RUN (ramp profile, points to staging):
//   BASE_URL=https://staging-almumayaz.vercel.app \
//   TEST_EMAIL=loadtest@example.com TEST_PASSWORD=Passw0rd! \
//   k6 run docs/loadtest/k6-capacity.js
//
// RUN a single fixed level (e.g. 1000 VUs for 3 min):
//   K6_VUS=1000 K6_DURATION=3m BASE_URL=... k6 run docs/loadtest/k6-capacity.js
//
// IMPORTANT
//   * Use a DISPOSABLE Firebase project / staging DB. These tests generate
//     real writes (heartbeats, analytics) and real Firebase egress $$$.
//   * Seed the users collection to the size you want to test (1k/10k/50k) so
//     the readData('users') whole-collection cost is realistic.
//   * Vercel Hobby forbids commercial + heavy load use; test on a plan that
//     allows it or you risk suspension.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const EMAIL = __ENV.TEST_EMAIL || 'loadtest@example.com';
const PASSWORD = __ENV.TEST_PASSWORD || 'Passw0rd!';
const COURSE_ID = __ENV.COURSE_ID || 'course1';
const LESSON_ID = __ENV.LESSON_ID || 'lesson1';

const dashboardTrend = new Trend('t_dashboard_ms', true);
const heartbeatTrend = new Trend('t_heartbeat_ms', true);
const loginTrend = new Trend('t_login_ms', true);
const pdfTokenTrend = new Trend('t_pdf_token_ms', true);
const errRate = new Rate('errors');
const timeouts = new Counter('timeouts');

// Ramp profile that mirrors the report's simulation points:
// 100 -> 500 -> 1000 -> 3000 -> 5000 -> 10000 -> 20000 concurrent VUs.
// Trim the later stages if your plan/wallet can't take it.
export const options = __ENV.K6_VUS ? {
  vus: parseInt(__ENV.K6_VUS, 10),
  duration: __ENV.K6_DURATION || '2m',
  thresholds: { http_req_duration: ['p(95)<3000'], errors: ['rate<0.02'] },
} : {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 100 },
        { duration: '2m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '3m', target: 3000 },
        { duration: '3m', target: 5000 },
        { duration: '3m', target: 10000 },
        { duration: '3m', target: 20000 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    errors: ['rate<0.02'],
    t_dashboard_ms: ['p(95)<4000'],
    t_heartbeat_ms: ['p(95)<2000'],
  },
};

function timed(trend, res) {
  trend.add(res.timings.duration);
  if (res.status === 0 || res.status === 504) timeouts.add(1);
  const ok = res.status >= 200 && res.status < 400;
  errRate.add(!ok);
  return ok;
}

export function setup() {
  // One shared login to get a cookie jar template is not enough (per-VU cookies),
  // so each VU logs in itself in default(). setup just sanity-checks the target.
  const r = http.get(`${BASE}/login`);
  check(r, { 'login page reachable': (x) => x.status === 200 });
  return {};
}

export default function () {
  const jar = http.cookieJar();

  // 1) LOGIN (exercises scryptSync — the blocking CPU path — + whole-users read)
  group('login', () => {
    const res = http.post(`${BASE}/login`, { email: EMAIL, password: PASSWORD }, {
      redirects: 0,
    });
    timed(loginTrend, res);
  });

  // 2) DASHBOARD (heaviest read path: users x2 + courses x2 + analytics + settings + chats)
  group('dashboard', () => {
    const res = http.get(`${BASE}/student`);
    timed(dashboardTrend, res);
  });

  // 3) LESSON PAGE
  group('lesson', () => {
    const res = http.get(`${BASE}/student/lesson/${COURSE_ID}/${LESSON_ID}`);
    timed(new Trend('t_lesson_ms', true), res);
  });

  // 4) VIDEO HEARTBEAT burst (real client sends 1 every 15s; here we sample a few)
  group('heartbeat', () => {
    for (let i = 0; i < 3; i++) {
      const res = http.post(`${BASE}/api/analytics/video/heartbeat`,
        JSON.stringify({ courseId: COURSE_ID, lessonId: LESSON_ID, position: 30 + i * 15, duration: 600, watchedSeconds: 15, forceComplete: false }),
        { headers: { 'Content-Type': 'application/json' } });
      timed(heartbeatTrend, res);
      sleep(1);
    }
  });

  // 5) PDF token (mint) — the PDF byte-stream itself is intentionally NOT hammered
  //    here because it streams full files through Vercel and will burn bandwidth $$$.
  group('pdf_token', () => {
    const res = http.get(`${BASE}/api/student/pdf-token/lesson/${COURSE_ID}/${LESSON_ID}/0`);
    timed(pdfTokenTrend, res);
  });

  sleep(Math.random() * 3 + 2); // think time 2-5s
}
