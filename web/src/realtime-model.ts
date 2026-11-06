/** Browser-side compact notification contract. No database or Runtime imports. */
export type ChangeEntity = 'task'|'execution'|'verification'|'employee'|'project'
export interface ChangeNotice {entity:ChangeEntity;resourceId:string;ticketId?:string;at:string}
export type ChangeMessage =
  | {type:'change';cursor:string;notice:ChangeNotice}
  | {type:'reset';cursor:string;reason:'initial'|'expired'|'replaced'|'future'}
  | {type:'ready';cursor:string}
export type ChangeConnectionState = 'connecting'|'live'|'reconnecting'|'offline'|'unauthorized'
export interface ChangeStreamClient {
  run(options:{signal:AbortSignal;onEvent:(message:ChangeMessage)=>void|Promise<void>;onState:(state:ChangeConnectionState)=>void}):Promise<void>
}
export type OpenChangeStream = (input:{cursor?:string;signal:AbortSignal})=>Promise<Response>
