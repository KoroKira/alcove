import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Matches the Pydantic model in workspace_router.py
export interface WorkspaceState {
  id: string;
  state: string; // e.g., "pending", "starting", "running", "stopping", "stopped", "failed", "canceling", "canceled", "deleting", "deleted"
  name: string;
  username: string;
  base_url: string;
  agent: string;
}

export class WorkspaceIntegrationDisabledError extends Error {
  constructor() {
    super('Workspace management is not configured on this Alcove instance.');
    this.name = 'WorkspaceIntegrationDisabledError';
  }
}

const isWorkspaceIntegrationDisabled = (error: unknown): error is WorkspaceIntegrationDisabledError =>
  error instanceof WorkspaceIntegrationDisabledError;

const detailMessage = (detail: unknown): string | undefined => {
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') {
    return detail.message;
  }
  return undefined;
};

const WORKSPACE_QUERY_KEY = ['workspaceState'];

// API function to fetch workspace state (https://pkg.go.dev/github.com/coder/coder/codersdk#WorkspaceStatus)
const fetchWorkspaceState = async (): Promise<WorkspaceState> => {
  try {
    const response = await fetch('/api/workspace/state');

    if (!response.ok) {
      let errorMessage = `Failed to fetch workspace state. Status: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = detailMessage(errorData?.detail) ?? errorMessage;
      } catch (e) {
        // Ignore if error response cannot be parsed
      }
      if (response.status === 503 && errorMessage.includes('not configured')) {
        throw new WorkspaceIntegrationDisabledError();
      }
      throw new Error(errorMessage);
    }

    const jsonData = await response.json();
    
    if (!jsonData || typeof jsonData.state !== 'string') {
        throw new Error('Invalid data structure received for workspace state.');
    }

    return jsonData as WorkspaceState;

  } catch (error) {
    throw error;
  }
};

// API function to start the workspace
const callStartWorkspace = async (): Promise<any> => {
  const response = await fetch('/api/workspace/start', {
    method: 'POST',
  });
  if (!response.ok) {
    let errorMessage = 'Failed to start workspace.';
    try {
      const errorData = await response.json();
      if (errorData && errorData.detail) {
        errorMessage = errorData.detail;
      }
    } catch (e) {
      // Error response parsing failed
    }
    throw new Error(errorMessage);
  }
  return response.json();
};

// API function to stop the workspace
const callStopWorkspace = async (): Promise<any> => {
  const response = await fetch('/api/workspace/stop', {
    method: 'POST',
  });
  if (!response.ok) {
    let errorMessage = 'Failed to stop workspace.';
    try {
      const errorData = await response.json();
      if (errorData && errorData.detail) {
        errorMessage = errorData.detail;
      }
    } catch (e) {
      // Error response parsing failed
    }
    throw new Error(errorMessage);
  }
  return response.json();
};

export const useWorkspace = () => {
  const queryClient = useQueryClient();

  const {
    data: workspaceState,
    isLoading: isLoadingState,
    error: stateError,
    isError: isStateError,
    refetch: refetchWorkspaceState,
  } = useQuery<WorkspaceState, Error>({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: fetchWorkspaceState,
    // Do not repeatedly hit the API when this optional integration is not set
    // up. Other workspace errors can recover, so keep polling those.
    refetchInterval: (query) =>
      isWorkspaceIntegrationDisabled(query.state.error) ? false : 5000,
  });

  const startMutation = useMutation<any, Error, void>({
    mutationFn: callStartWorkspace,
    onSuccess: () => {
      // Invalidate and refetch workspace state after starting
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });

  const stopMutation = useMutation<any, Error, void>({
    mutationFn: callStopWorkspace,
    onSuccess: () => {
      // Invalidate and refetch workspace state after stopping
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
    },
  });

  return {
    workspaceState,
    isLoadingState,
    stateError,
    isStateError,
    refetchWorkspaceState,

    startWorkspace: startMutation.mutate,
    isStarting: startMutation.isPending,
    startError: startMutation.error,
    isStartError: startMutation.isError,

    stopWorkspace: stopMutation.mutate,
    isStopping: stopMutation.isPending,
    stopError: stopMutation.error,
    isStopError: stopMutation.isError,
  };
};
