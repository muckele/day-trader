export function getApiError(error) {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed.';
}

export function getApiBaseUrl() {
  return import.meta.env.VITE_API_URL || '';
}
