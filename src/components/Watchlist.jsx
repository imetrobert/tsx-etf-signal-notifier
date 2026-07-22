import Navbar from './Navbar'

export default function Watchlist({ session }) {
  return (
    <div className="app-layout">
      <Navbar />
      <main className="main-content">
        <div className="page-header">
          <h1>Watchlist</h1>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="empty-state">
              <h3>Coming in stage 2</h3>
              <p>Add and remove TSX ETFs to monitor beyond your holdings.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
