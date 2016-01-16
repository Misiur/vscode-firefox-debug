import { EventEmitter } from 'events';
import { DebugConnection } from '../connection';
import { PendingRequests } from './pendingRequests';
import { ActorProxy } from './interface';
import { PauseActorProxy } from './pause';
import { SourceActorProxy } from './source';

export class ThreadActorProxy extends EventEmitter implements ActorProxy {

	private pendingPauseRequests = new PendingRequests<PauseActorProxy>();
	private pendingDetachRequests = new PendingRequests<void>();
	private pendingSourceRequests = new PendingRequests<SourceActorProxy[]>();
	private pendingFrameRequests = new PendingRequests<FirefoxDebugProtocol.Frame[]>();
	
	private knownToBePaused: boolean = false;
	
	constructor(private _name: string, private connection: DebugConnection) {
		super();
		this.connection.register(this);
	}

	public static createAndAttach(name: string, connection: DebugConnection): Promise<ThreadActorProxy> {
		let threadActor = new ThreadActorProxy(name, connection);
		return threadActor.attach().then(() => threadActor);
	}
	
	public get name() {
		return this._name;
	}

	public runOnPausedThread<T>(action: (resume: () => void) => (T | Thenable<T>)): Promise<T> {
		return new Promise<T>((resolve) => {
			if (this.knownToBePaused) {
				resolve(action(() => {}));
			} else {
				resolve(this.interrupt().then(() => {
					return action(() => this.resume());
				}));
			}
		});
	}
	
	private attach(): Promise<PauseActorProxy> {
		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'attach' });
		});
	}

	public interrupt(): Promise<PauseActorProxy> {
		return new Promise<PauseActorProxy>((resolve, reject) => {
			this.pendingPauseRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'interrupt' });
		});
	}

	public fetchSources(): Promise<SourceActorProxy[]> {
		return new Promise<SourceActorProxy[]>((resolve, reject) => {
			this.pendingSourceRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'sources' });
		});
	}
	
	public fetchStackFrames(): Promise<FirefoxDebugProtocol.Frame[]> {
		return new Promise<FirefoxDebugProtocol.Frame[]>((resolve, reject) => {
			this.pendingFrameRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'frames' });
		});
	}
	
	public resume(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume' });
	}
	
	public stepOver(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'next' }});
	}
	
	public stepInto(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'step' }});
	}
	
	public stepOut(): void {
		this.knownToBePaused = false;
		this.connection.sendRequest({ to: this.name, type: 'resume', resumeLimit: { type: 'finish' }});
	}
	
	//TODO also detach the TabActorProxy(?)
	public detach(): Promise<void> {
		this.knownToBePaused = false;
		return new Promise<void>((resolve, reject) => {
			this.pendingDetachRequests.enqueue({ resolve, reject });
			this.connection.sendRequest({ to: this.name, type: 'detach' });
		});
	}
	
	public receiveResponse(response: FirefoxDebugProtocol.Response): void {
		
		if (response['type'] === 'paused') {

			this.knownToBePaused = true;			
			let pausedResponse = <FirefoxDebugProtocol.ThreadPausedResponse>response;
			let pauseActor = this.connection.getOrCreate(pausedResponse.actor,
				() => new PauseActorProxy(pausedResponse.actor, this.connection));
			this.pendingPauseRequests.resolveAll(pauseActor);
			this.pendingDetachRequests.rejectAll('paused');
			this.emit('paused', pausedResponse.why);

		} else if (response['type'] === 'exited') {
			
			this.pendingPauseRequests.rejectAll('exited');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('exited');
			//TODO send release packet(?)
			
		} else if (response['error'] === 'wrongState') {
			
			this.pendingPauseRequests.rejectAll('wrongState');
			this.pendingDetachRequests.rejectAll('wrongState');
			this.emit('wrongState');
			
		} else if (response['type'] === 'detached') {
			
			this.pendingPauseRequests.rejectAll('detached');
			this.pendingDetachRequests.resolveAll(null);
			this.emit('detached');
			
		} else if (response['type'] === 'newSource') {
			
			let source = <FirefoxDebugProtocol.Source>(response['source']);
			let sourceActor = this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection));
			this.emit('newSource', sourceActor);
			
		} else if (response['sources']) {

			let sources = <FirefoxDebugProtocol.Source[]>(response['sources']);
			let sourceActors = sources.map((source) => this.connection.getOrCreate(source.actor, 
				() => new SourceActorProxy(source, this.connection)));
			this.pendingSourceRequests.resolveOne(sourceActors);
			
		} else if (response['frames']) {

			let frames = <FirefoxDebugProtocol.Frame[]>(response['frames']);
			this.pendingFrameRequests.resolveOne(frames);
			
		} else {

			if ((response['type'] !== 'newGlobal') && (response['type'] !== 'resumed')) {
				console.log("Unknown message from ThreadActor: ", JSON.stringify(response));
			}			

		}
			
	}
	
	public onPaused(cb: (why: string) => void) {
		this.on('paused', cb);
	}

	public onExited(cb: () => void) {
		this.on('exited', cb);
	}

	public onWrongState(cb: () => void) {
		this.on('wrongState', cb);
	}

	public onDetached(cb: () => void) {
		this.on('detached', cb);
	}
	
	public onNewSource(cb: (newSource: SourceActorProxy) => void) {
		this.on('newSource', cb);
	}
}