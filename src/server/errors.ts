export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const forbidden = () => new HttpError(403, 'FORBIDDEN', 'You do not have access to this action.');
export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found or no longer available.');
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
