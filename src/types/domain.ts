export interface User {
  id: string;
  authSubject: string;
  email: string | null;
  displayName: string | null;
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  updatedAt: string;
}
