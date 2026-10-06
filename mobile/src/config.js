import 'react-native-url-polyfill/auto';

// Deployed backend address.
export const SERVER_URL = 'http://111.118.189.182:3003';

export const REQUEST_TIMEOUT_MS = 12000;

export function normalizeServerUrl(value) {
  let url;

  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(
      'Enter a complete server URL, including http:// or https://.',
    );
  }

  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Use an HTTP or HTTPS server address without login details.',
    );
  }

  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      'Server URL must contain only the server address, without a path or invitation.',
    );
  }

  return url.origin;
}