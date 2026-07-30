import { type NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const hasAccessCookie = Boolean(request.cookies.get('zoryqon_access')?.value);
  const hasSessionCookie = Boolean(request.cookies.get('zoryqon_session')?.value);
  if (hasAccessCookie && hasSessionCookie) return NextResponse.next();

  const login = new URL('/login', request.url);
  login.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    '/portfolio/:path*',
    '/orders/:path*',
    '/wallet/:path*',
    '/verification/:path*',
    '/settings/:path*',
  ],
};
