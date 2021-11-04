export interface FileDescriptor {
  contents(): Promise<string>;
  readonly path: string;
  readonly uri: string;
}
