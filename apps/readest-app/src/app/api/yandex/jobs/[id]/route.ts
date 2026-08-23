import { NextRequest, NextResponse } from 'next/server';
import { validateUserAndToken } from '@/utils/access';
import { deleteJobRow, getServerYandexRunner, readJob } from '@/services/yandex/serverYandexRunner';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/yandex/jobs/[id] — { action: 'pause' | 'resume' | 'cancel', token? }
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const { user } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  let body: { action?: unknown; token?: unknown };
  try {
    body = (await request.json()) as { action?: unknown; token?: unknown };
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  const runner = getServerYandexRunner();
  const job = await readJob(user.id, id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404, headers: CORS_HEADERS });
  }

  if (body.action === 'pause') {
    await runner.pauseJob(user.id, id);
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  }

  if (body.action === 'cancel') {
    if (runner.isActive(user.id, id)) {
      runner.cancel(user.id, id);
    } else {
      await runner.cancelIdle(user.id, id);
    }
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  }

  if (body.action === 'resume') {
    // The token is required on resume (chapter CDN urls are re-resolved
    // server-side) and is never persisted.
    if (typeof body.token !== 'string' || !body.token.trim()) {
      return NextResponse.json(
        { error: 'Yandex token required' },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    if (runner.isActive(user.id, id)) {
      return NextResponse.json(
        { error: 'Job is already running' },
        { status: 409, headers: CORS_HEADERS },
      );
    }
    try {
      await runner.resume(user.id, id, body.token);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Resume failed' },
        { status: 400, headers: CORS_HEADERS },
      );
    }
    return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400, headers: CORS_HEADERS });
}

// DELETE /api/yandex/jobs/[id] — dismiss a finished row; paused rows clean up first.
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const { user } = await validateUserAndToken(request.headers.get('authorization'));
  if (!user) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 403, headers: CORS_HEADERS },
    );
  }

  const runner = getServerYandexRunner();
  const job = await readJob(user.id, id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404, headers: CORS_HEADERS });
  }

  if (job.status === 'completed' || job.status === 'failed') {
    await deleteJobRow(user.id, id);
  } else if (runner.isActive(user.id, id)) {
    runner.cancel(user.id, id);
  } else {
    await runner.cancelIdle(user.id, id);
  }
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
