export interface ExitNode {
  id: string;
}

export class ExitSelector {
  constructor(
    private exits: ExitNode[],
    private computeRoute: (from: string, to: string) => { cost: number }
  ) {}

  selectBestExit(currentNode: string): string | null {
    let bestExit: string | null = null;
    let bestScore = Infinity;

    for (const exit of this.exits) {
      const route = this.computeRoute(currentNode, exit.id);
      if (route.cost < bestScore) {
        bestScore = route.cost;
        bestExit = exit.id;
      }
    }

    return bestExit;
  }
}
