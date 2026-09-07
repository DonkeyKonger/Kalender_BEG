type AuthSession = {
  getToken: () => string | null;
  refreshToken: () => Promise<string | null>;
};

/** Share the same single retry for JSON and file downloads. */
export async function fetchWithAuthRefresh(
  url: string,
  options: RequestInit,
  session: AuthSession,
  retryOnUnauthorized = true,
): Promise<Response> {
  const send = (token: string | null) => {
    options.signal?.throwIfAborted();
    const headers = new Headers(options.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...options, headers });
  };
  const token = session.getToken();
  const response = await send(token);
  if (response.status !== 401 || !retryOnUnauthorized || !token || !session.getToken()) {
    return response;
  }
  options.signal?.throwIfAborted();
  // Another in-flight request may already have refreshed the same session.
  const refreshed = session.getToken() !== token
    ? session.getToken()
    : await session.refreshToken();
  options.signal?.throwIfAborted();
  return refreshed ? send(refreshed) : response;
}
