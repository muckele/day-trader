import { render, screen } from '@testing-library/react';
import App from './App';
import axios from 'axios';

test('renders login screen by default when unauthenticated', async () => {
  axios.get.mockRejectedValue({ response: { status: 401, data: { error: 'Authentication required' } } });
  render(<App />);
  const heading = await screen.findByRole('heading', { name: /login/i });
  expect(heading).toBeInTheDocument();
});
