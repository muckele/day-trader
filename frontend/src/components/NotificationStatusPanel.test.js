import React from 'react';
import { render, screen } from '@testing-library/react';
import axios from 'axios';
import NotificationStatusPanel from './NotificationStatusPanel';
test('notification delivery states distinguish queue, retry and provider acceptance from inbox receipt', async () => {
 axios.get.mockResolvedValue({data:{events:['pending','sending','retryable','provider_accepted','failed'].map((state,i)=>({_id:String(i),state,subject:`Event ${i}`,attempts:i}))}});
 render(<NotificationStatusPanel />);
 expect(await screen.findByText('Queued')).toBeInTheDocument();
 expect(screen.getByText('Sending · confirmation pending')).toBeInTheDocument();
 expect(screen.getByText('Failed attempt · retry scheduled')).toBeInTheDocument();
 expect(screen.getByText('Provider accepted')).toBeInTheDocument();
 expect(screen.getByText('Failed · operator review required')).toBeInTheDocument();
 expect(screen.getByText(/does not prove inbox receipt/)).toBeInTheDocument();
});
