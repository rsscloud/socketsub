export type PushProtocol = 'rsscloud' | 'websub';

export type ServerMessage =
    | {
          type: 'status';
          url: string;
          state: 'pending' | 'subscribed' | 'unsupported' | 'error';
          via?: PushProtocol;
          detail?: string;
      }
    | { type: 'update'; url: string }
    | { type: 'error'; message: string };

export type StatusMessage = Extract<ServerMessage, { type: 'status' }>;

export type Client = { send(message: ServerMessage): void };
