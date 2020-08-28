/**
 * Metacom
 */
export class Metacom {
  /** url */
  url: string
  /** socket */
  socket: WebSocket
  /** api */
  api: any
  /** callId */
  callId: number
  /** calls */
  calls: Map<any, any>
  /**
   * constructor
   * @param url host
   */
  constructor(url: string)
  /**
   * ready
   */
  ready(): Promise
  /**
   * load folder
   * @param group
   */
  load(...group: string): Promise<void>
  /**
   * httpCall
   * @param iname name
   * @param ver version
   */
  httpCall(iname: string, ver: string)
  /**
   * socketCall
   * @param iname name
   * @param ver version
   */
  socketCall(iname: string, ver: string)
}
