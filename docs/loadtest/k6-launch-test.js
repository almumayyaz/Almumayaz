import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = 'https://almumayaz.online';
const errorRate = new Rate('errors');
const pageLoadTrend = new Trend('page_load_time');
const apiTrend = new Trend('api_response_time');

const STAGES = [
  { target: 100, duration: '30s' },   // Ramp to 100 users
  { target: 100, duration: '30s' },   // Stay at 100
  { target: 500, duration: '30s' },   // Ramp to 500
  { target: 500, duration: '30s' },   // Stay at 500
  { target: 1000, duration: '30s' },  // Ramp to 1000
  { target: 1000, duration: '30s' },  // Stay at 1000
  { target: 0, duration: '30s' },     // Ramp down
];

export let options = {
  stages: STAGES,
  thresholds: {
    http_req_duration: ['p(95)<3000', 'p(99)<5000'],
    errors: ['rate<0.10'],
  },
  noConnectionReuse: true,
  userAgent: 'K6-LoadTest/1.0',
};

const PUBLIC_ENDPOINTS = [
  { url: '/', method: 'GET', name: 'homepage' },
  { url: '/courses', method: 'GET', name: 'courses' },
  { url: '/login', method: 'GET', name: 'login_page' },
  { url: '/register', method: 'GET', name: 'register_page' },
  { url: '/subscriptions', method: 'GET', name: 'subscriptions' },
  { url: '/support', method: 'GET', name: 'support_page' },
  { url: '/api/dev/status', method: 'GET', name: 'api_status' },
];

export default function() {
  group('Public Pages', function() {
    PUBLIC_ENDPOINTS.forEach(function(ep) {
      const res = http.request(ep.method, BASE_URL + ep.url);
      const passed = check(res, {
        [`${ep.name} status 200/302`]: (r) => r.status === 200 || r.status === 302,
      });
      errorRate.add(!passed);
      pageLoadTrend.add(res.timings.duration);
      sleep(Math.random() * 2 + 0.5);
    });
  });

  group('Student Pages (unauthenticated)', function() {
    const studentPages = [
      '/student',
      '/student/courses',
      '/student/live-sessions',
      '/student/notifications',
    ];
    studentPages.forEach(function(path) {
      const res = http.get(BASE_URL + path);
      const passed = check(res, {
        [`${path} → redirect to login`]: (r) => r.status === 302 || r.status === 301,
      });
      errorRate.add(!passed);
      apiTrend.add(res.timings.duration);
      sleep(1);
    });
  });

  group('Login Attempt (invalid credentials)', function() {
    const payload = JSON.stringify({
      email: 'test@loadtest.com',
      password: 'wrongpassword123',
    });
    const res = http.post(BASE_URL + '/login', payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    const passed = check(res, {
      'login fails gracefully': (r) => r.status === 401 || r.status === 200,
    });
    errorRate.add(!passed);
    apiTrend.add(res.timings.duration);
    sleep(1);
  });

  group('API Public Endpoints', function() {
    const apiCalls = [
      '/api/unread-count',
      '/api/student/quote',
      '/api/live-sessions/upcoming',
    ];
    apiCalls.forEach(function(path) {
      const res = http.get(BASE_URL + path);
      apiTrend.add(res.timings.duration);
      sleep(0.5);
    });
  });
}
