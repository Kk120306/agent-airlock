export function valueForSelectedAgent<T extends { agentId: string }>(
  selectedAgentId: string | null,
  value: T | null,
): T | null {
  return value?.agentId === selectedAgentId ? value : null;
}
