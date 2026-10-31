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
  /** iOS: opens `/employees/<uuid>` of the OpenDot Runtime host full screen in an isolated web view signed in with the stored session. */
  openRoom(options: {path: string}): Promise<void>;
  closeRoom(): Promise<void>;
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
