import Navbar from './Navbar'

export default function SignalHistory({ session }) {
  return (
    <div className="app-layout">
      <Navbar />
      <main className="main-content">
        <div className="page-header">
          <h1>Signal History</h1>
        </div>
        <div className="card">
          <div className="card-body">
            <div className="empty-state">
              <h3>Coming in stage 3</h3>
              <p>Every buy/sell signal the daily job fires will be logged here.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
