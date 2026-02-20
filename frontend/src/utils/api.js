export function getApiError(error) {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || 'Request failed.';
}

export function getApiBaseUrl() {
  return process.env.REACT_APP_API_URL || process.env.VITE_API_URL || '';
}
