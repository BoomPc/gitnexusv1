declare module 'graphology-types' {
  export type Attributes = Record<string, unknown>;
  export type NodeAttributes = Attributes;
  export type EdgeAttributes = Attributes;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class AbstractGraph<NAttr = any, EAttr = any, GAttr = any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }
}
