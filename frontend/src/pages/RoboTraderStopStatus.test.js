import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import RoboTrader from './RoboTrader';

jest.mock('axios');
const draining = { state: 'draining', admissionsDisabled: true, unresolved: [{ intentId: 'intent-1', clientOrderId: 'mvp-original', status: 'submission_uncertain', dispatchClaimed: true }] };
const stopped = { state: 'stopped', admissionsDisabled: true, unresolved: [] };
let savedSettings;
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  savedSettings = { isEnabled: true, mode: 'paper', stopStatus: { state: 'running', admissionsDisabled: false, unresolved: [] } };
  axios.get.mockImplementation(async url => ({ data: url.endsWith('/settings') ? { settings: savedSettings } : {} }));
});
afterEach(() => jest.restoreAllMocks());

test('emergency response shows unresolved identity and never claims completion when refresh fails', async () => {
  axios.post.mockImplementation(async () => {
    axios.get.mockRejectedValue(new Error('Refresh unavailable'));
    return { data: { settings: { isEnabled: false, mode: 'paper' }, stopStatus: draining } };
  });
  render(<RoboTrader />);
  fireEvent.click(await screen.findByRole('button', { name: 'Emergency Stop' }));
  const panel = await screen.findByRole('region', { name: 'Automation stop status' });
  await waitFor(() => expect(within(panel).getByText('mvp-original')).toBeInTheDocument());
  expect(within(panel).getByText('Stopping — earlier dispatches unresolved')).toBeInTheDocument();
  expect(screen.queryByText('Emergency stop completed.')).not.toBeInTheDocument();
  expect(within(panel).queryByText('Fully stopped')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Enable RoboTrader' })).toBeInTheDocument();
});

test('disable reports draining and a confirmed refresh can reach fully stopped', async () => {
  axios.post.mockImplementation(async () => {
    savedSettings = { isEnabled: false, mode: 'paper', stopStatus: draining };
    return { data: { settings: savedSettings } };
  });
  render(<RoboTrader />);
  fireEvent.click(await screen.findByRole('button', { name: 'Disable RoboTrader' }));
  await screen.findByText('Stopping — earlier dispatches unresolved');
  savedSettings = { ...savedSettings, stopStatus: stopped };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh stop status' }));
  expect(await screen.findByText('Fully stopped')).toBeInTheDocument();
  expect(screen.queryByText('mvp-original')).not.toBeInTheDocument();
});

test('disabled controls without stop evidence remain unconfirmed', async () => {
  savedSettings = { isEnabled: false, mode: 'paper' };
  render(<RoboTrader />);
  expect(await screen.findByText('Stop status unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Fully stopped')).not.toBeInTheDocument();
});

test('confirmed empty drain allows truthful emergency completion', async () => {
  axios.post.mockImplementation(async () => {
    savedSettings = { isEnabled: false, mode: 'paper', stopStatus: stopped };
    return { data: { settings: savedSettings, stopStatus: stopped } };
  });
  render(<RoboTrader />);
  fireEvent.click(await screen.findByRole('button', { name: 'Emergency Stop' }));
  expect(await screen.findByText('Emergency stop confirmed: earlier automated dispatches have drained.')).toBeInTheDocument();
  expect(screen.getByText('Fully stopped')).toBeInTheDocument();
});

test('enabled but paused controls show paused admissions and distinguish an empty drain from disable', async () => {
  savedSettings = { isEnabled: true, mode: 'paper', pausedReason: 'Risk review required.', stopStatus: { ...stopped, paused: true } };
  render(<RoboTrader />);
  expect(await screen.findByText('Automated entries paused')).toBeInTheDocument();
  expect(screen.queryByText('Automated entries enabled')).not.toBeInTheDocument();
  expect(screen.queryByText('Fully stopped')).not.toBeInTheDocument();
  expect(screen.getByText(/Earlier automated dispatches have drained; the pause still blocks new entries/)).toBeInTheDocument();
});

test('paused controls retain the unresolved dispatch warning', async () => {
  savedSettings = { isEnabled: true, mode: 'paper', stopStatus: { ...draining, paused: true } };
  render(<RoboTrader />);
  expect(await screen.findByText('Paused — earlier dispatches unresolved')).toBeInTheDocument();
  expect(screen.getByText('mvp-original')).toBeInTheDocument();
  expect(screen.queryByText('Fully stopped')).not.toBeInTheDocument();
});
