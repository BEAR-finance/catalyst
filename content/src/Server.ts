import cors from "cors";
import express, { RequestHandler } from "express";
import morgan from "morgan";
import multer from "multer";
import { Controller } from "./controller/Controller";
import { Environment, Bean, SERVER_PORT } from "./Environment";

export class Server {
   private port: number;
   private app: express.Express;

   constructor(env: Environment) {
      this.port = env.getConfig(SERVER_PORT);

      this.app = express();
      const upload = multer({ dest: 'uploads/' })
      const controller: Controller = env.getBean(Bean.CONTROLLER)

      this.app.use(cors());
      this.app.use(express.json());
      this.app.use(morgan("combined"));
      
      this.registerRoute("/entities/:type"       , controller, controller.getEntities)
      this.registerRoute("/entities"             , controller, controller.createEntity, true, upload.any())
      this.registerRoute("/contents/:hashId"     , controller, controller.getContent);
      this.registerRoute("/available-content"    , controller, controller.getAvailableContent);
      this.registerRoute("/pointers/:type"       , controller, controller.getPointers);
      this.registerRoute("/audit/:type/:entityId", controller, controller.getAudit);
      this.registerRoute("/history"              , controller, controller.getHistory);

      // TODO: Create a version endpoint 

   }

   private registerRoute(route: string, controller: Controller, action: (req: express.Request, res: express.Response)=>void, isPost?:boolean, extraHandler?: RequestHandler) {
      const handlers: RequestHandler[] = [(req: express.Request, res: express.Response) => action.call(controller, req,res)]
      if (extraHandler) {
         handlers.unshift(extraHandler)
      }
      if (!isPost) {
         this.app.get(route, handlers);
      } else {
         this.app.post(route, handlers);
      }
   }

   start(): void {
      this.app.listen(this.port, () => {
         console.info(`==> Content Server listening on port ${this.port}.`);
       });
   }
}