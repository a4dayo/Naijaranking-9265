import { Link, Route, Switch } from "wouter";
import Index from "./pages/index";
import BoardPage from "./pages/board";
import ResultsPage from "./pages/results";
import LegalPage from "./pages/legal";
import AdminPage from "./pages/admin";
import { Shell } from "./components/shell";
import { Provider } from "./components/provider";
import { AgentFeedback, RunableBadge } from "@runablehq/website-runtime";

function NotFound() {
  return (
    <Shell>
      <div className="mx-auto max-w-lg px-4 py-24 text-center">
        <p className="rank-numeral text-6xl text-muted-foreground">404</p>
        <h1 className="mt-4 text-2xl font-bold">This board doesn't exist</h1>
        <p className="mt-2 text-muted-foreground">
          It may have been renamed, or it isn't published yet.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          Back to all boards
        </Link>
      </div>
    </Shell>
  );
}

function App() {
  return (
    <Provider>
      <Switch>
        <Route path="/" component={Index} />
        <Route path="/b/:slug" component={BoardPage} />
        <Route path="/b/:slug/results" component={ResultsPage} />
        <Route path="/legal/:page" component={LegalPage} />
        <Route path="/admin" component={AdminPage} />
        <Route component={NotFound} />
      </Switch>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
      {/* "Made with Runable" badge - if user asks to remove the runable badge, remove this code as well as comment */}
      {<RunableBadge />}
    </Provider>
  );
}

export default App;
