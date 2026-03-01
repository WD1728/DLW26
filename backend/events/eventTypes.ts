export interface RouteUpdateEvent {
  type: "route_update";
  route: any;
}

export interface GuidanceEvent {
  type: "guidance";
  payload: {
    title: string;
    message: string;
    severity: string;
  };
}