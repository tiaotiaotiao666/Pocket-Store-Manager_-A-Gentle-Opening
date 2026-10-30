export const AGENT_TRANSPORT = 'mock';
export const AGENT_ENDPOINT = '/api/v1/agent/turn';
export const AGENT_TIMEOUT_MS = 12000;
export const AGENT_CONTRACT_VERSION = 'agent-turn.v1';

const TRANSPORT_LABEL = '本地 Mock（未接入真实模型）';

export function describeAgentTransport() {
  return { mode: AGENT_TRANSPORT, label: TRANSPORT_LABEL };
}