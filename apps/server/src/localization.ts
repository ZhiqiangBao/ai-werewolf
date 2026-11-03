import type { IncomingMessage } from 'node:http';
import { apiErrorText, gameLanguages, preferredLanguage, type LocalizedMessage } from '@werewolf/protocol';

export const requestLanguage = (req: IncomingMessage): string => preferredLanguage(req.headers['accept-language'], gameLanguages().map(({ id }) => id));
export const errorBody = (locale: string, code: string, localization?: LocalizedMessage) => ({ code, message: apiErrorText(locale, code, localization) });
