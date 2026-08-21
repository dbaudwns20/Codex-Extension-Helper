export interface DisposableLike {
  dispose(): void;
}

export class DisposableStore implements DisposableLike {
  private readonly resources: DisposableLike[] = [];
  private disposed = false;

  constructor(private readonly onDisposeError: (error: unknown) => void = () => undefined) {}

  use<T extends DisposableLike>(resource: T): T {
    if (this.disposed) {
      resource.dispose();
      throw new Error('Cannot own a resource after disposal');
    }
    this.resources.push(resource);
    return resource;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    for (const resource of this.resources.splice(0).reverse()) {
      try {
        resource.dispose();
      } catch (error) {
        try {
          this.onDisposeError(error);
        } catch {
          // A cleanup reporter must not prevent remaining resources from being disposed.
        }
      }
    }
  }
}

export function constructWithRollback<T>(
  construct: (resources: DisposableStore) => T,
  onDisposeError: (error: unknown) => void = () => undefined,
): { readonly value: T; readonly resources: DisposableStore } {
  const resources = new DisposableStore(onDisposeError);
  try {
    return { value: construct(resources), resources };
  } catch (error) {
    resources.dispose();
    throw error;
  }
}
