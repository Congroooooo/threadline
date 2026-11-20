import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ApiError } from "./api";
import { WorkspaceLayout } from "./components/Header";
import { Inbox } from "./pages/Inbox";
import { Join } from "./pages/Join";
import { Members } from "./pages/Members";
import { Project } from "./pages/Project";
import { Roles } from "./pages/Roles";
import { SignIn } from "./pages/SignIn";
import { Home, NewWorkspace, Welcome } from "./pages/Start";
import { Task } from "./pages/Task";
import { Tokens } from "./pages/Tokens";
import { Workspace } from "./pages/Workspace";
import "./styles.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Retrying cannot fix "not allowed" or "not found".
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
});

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/signin" element={<SignIn />} />
      <Route path="/join/:code" element={<Join />} />
      <Route path="/new" element={<NewWorkspace />} />
      <Route path="/welcome" element={<Welcome />} />
      <Route path="/w/:ws" element={<WorkspaceLayout />}>
        <Route index element={<Workspace />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="members" element={<Members />} />
        <Route path="roles" element={<Roles />} />
        <Route path="tokens" element={<Tokens />} />
        <Route path="p/:projectId" element={<Project />} />
        <Route path="t/:taskId" element={<Task />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
