export const GEMINI_OAUTH_CLIENT_ID_ENV_VAR = 'GEMINI_OAUTH_CLIENT_ID'
export const GEMINI_OAUTH_CLIENT_SECRET_ENV_VAR =
  'GEMINI_OAUTH_CLIENT_SECRET'
export const GEMINI_OAUTH_CALLBACK_PORT = 8085
export const GEMINI_OAUTH_CALLBACK_PATH = '/oauth2callback'
export const GEMINI_OAUTH_REDIRECT_URL = `http://localhost:${GEMINI_OAUTH_CALLBACK_PORT}${GEMINI_OAUTH_CALLBACK_PATH}`
export const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const
export const GEMINI_OAUTH_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth'
export const GEMINI_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GEMINI_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
export const GEMINI_OAUTH_USER_AGENT = 'google-api-nodejs-client/9.15.1'
export const GEMINI_OAUTH_API_CLIENT = 'gl-node/22.17.0'
