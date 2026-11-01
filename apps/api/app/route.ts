export function GET() {
  return Response.json({ service: 'oneshot-api', health: '/api/health', readiness: '/api/ready' }, {
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
