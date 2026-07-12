export interface CommitWorkspaceTransitionInput<State> {
  previous: State;
  next: State;
  render(state: State): void;
  close(state: State): void;
  deferClose(state: State, error: unknown): void;
}

export function commitWorkspaceTransition<State>(input: CommitWorkspaceTransitionInput<State>): State {
  try {
    input.render(input.next);
  } catch (renderError) {
    try {
      input.close(input.next);
    } catch (cleanupError) {
      deferCloseSafely(input, input.next, cleanupError);
      throw new Error(
        `${errorMessage(renderError)}; prepared workspace cleanup failed: ${errorMessage(cleanupError)}`,
        { cause: new AggregateError([renderError, cleanupError]) }
      );
    }
    throw renderError;
  }

  try {
    input.close(input.previous);
  } catch (cleanupError) {
    deferCloseSafely(input, input.previous, cleanupError);
  }
  return input.next;
}

function deferCloseSafely<State>(
  input: CommitWorkspaceTransitionInput<State>,
  state: State,
  error: unknown
): void {
  try {
    input.deferClose(state, error);
  } catch {
    // The rendered workspace is already committed; do not turn cleanup bookkeeping into a failed switch.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
