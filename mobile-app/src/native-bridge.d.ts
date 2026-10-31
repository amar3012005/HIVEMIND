/** Register with Capacitor.registerPlugin<SingulanceNative>('SingulanceNative'). */
export interface SingulanceNative {
  /** OS accessibility hints, read on launch/resume; unsupported fields are omitted. */
  getAppearance(): Promise<{platform: 'ios' | 'android'; reduceMotion: boolean; reduceTransparency?: boolean; increaseContrast?: boolean}>;
  setCredential(options: {key: 'pendingAuth' | 'cpToken'; value: string}): Promise<void>;
  getCredential(options: {key: 'pendingAuth' | 'cpToken'}): Promise<{value: string | null}>;
  removeCredential(options: {key: 'pendingAuth' | 'cpToken'}): Promise<void>;
  request(options: {
    url: string;
    method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Partial<Record<'Accept' | 'Content-Type', string>>;
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
    responseType?: 'text' | 'base64';
    /** Injects securely stored CP bearer only for api.singulancelabs.com. */
    authorize?: boolean;
  }): Promise<{status: number; headers: Record<string,string>; data: string; encoding?: 'text' | 'base64'}>;
  /** Asks the account workspace-access endpoint (flag plus grant) with the stored session; only the verdict returns. */
  workspaceAccess(): Promise<{status: number; enabled?: boolean}>;
  /**
   * iOS: opens `/employees/<uuid>` of the OpenDot Runtime host full screen, signed in with the stored session. With `scope`
   * (`org:user`, iOS 17+) the room keeps one persistent web store for that scope and removes the stores of other scopes;
   * without it the store is discarded on close. Control's session cookie is deleted from the store when the room closes.
   */
  openRoom(options: {path: string; scope?: string}): Promise<void>;
  /** Loads the room hidden so a later openRoom shows it already rendered; at most one room is kept warm. */
  prewarmRoom(options: {path: string; scope?: string}): Promise<void>;
  /** Small non-secret settings kept in the Keychain (they survive a reinstall). Only `privacyChoice`; values up to 4 KiB. */
  getPreference(options: {key: 'privacyChoice'}): Promise<{value: string | null}>;
  setPreference(options: {key: 'privacyChoice'; value: string}): Promise<void>;
  removePreference(options: {key: 'privacyChoice'}): Promise<void>;
  closeRoom(): Promise<void>;
  /** Plays system haptic feedback; rejects for any other kind. Android maps kinds to the closest predefined effect and honours the system touch-feedback setting. */
  haptic(options: {kind: 'light' | 'soft' | 'warning' | 'success' | 'selection' | 'error'}): Promise<void>;
  /** Opens this app's page in the system Settings. */
  openSettings(): Promise<void>;
  addListener(event: 'roomClosed', listener: () => void): Promise<{remove():Promise<void>}>;
  /** User-initiated OS document picker. No filesystem path/URI accepted. Max 20 MiB. */
  saveFile(options: {name: string; mimeType: string; dataBase64: string}): Promise<{saved:boolean}>;
  /** Opens one logical Remote stream over a fixed native WebSocket. */
  openStream(options: {id: string; endpoint: string; payload: unknown}): Promise<void>;
  closeStream(options: {id: string}): Promise<void>;
  addListener(event: 'streamEvent', listener: (value: {
    id: string;
    type: 'open' | 'frame' | 'end' | 'error';
    /** Raw JSON Remote server frame for type=frame, generic error text otherwise. */
    data?: string;
  }) => void): Promise<{remove():Promise<void>}>;
}
