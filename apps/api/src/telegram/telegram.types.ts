export interface TelegramIdentity {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  displayName: string;
  source: 'telegram' | 'demo';
}

export interface TelegramBotProfile {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramMessageResult {
  message_id: number;
  chat: {
    id: number;
    title?: string;
    username?: string;
    type: string;
  };
}
