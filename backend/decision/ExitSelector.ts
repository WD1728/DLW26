export interface ExitNode {
  id: string;
}

export class ExitSelector {
  constructor(
    private exits: ExitNode[],
    private computeRoute: (from: string, to: string) => { est?: { distance: number } }
  ) {}

  selectBestExit(currentNode: string): string | null {
    let bestExit: string | null = null;
    let bestScore = Infinity;

    for (const exit of this.exits) {
      try {
        const route = this.computeRoute(currentNode, exit.id);
        const cost = Number(route?.est?.distance ?? Infinity);
        if (cost < bestScore) {
          bestScore = cost;
          bestExit = exit.id;
        }
      } catch {
        // Ignore exits that cannot be routed to.
      }
    }

    return bestExit;
  }
}
