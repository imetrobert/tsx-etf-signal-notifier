import Navbar from './Navbar'

export default function Dashboard({ session }) {
  return (
    <div className="app-layout">
      <Navbar />
      <main className="main-content">
        <div className="page-header">
          <h1>My Holdings</h1>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="empty-state">
              <h3>Stage 1 scaffold deployed</h3>
              <p>Login works. Holdings entry and live values arrive in stage 2.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
