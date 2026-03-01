import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import StaffHome from './pages/StaffHome';

function App() {
  return (
    <Router>
      <div className="App">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/staff" element={<StaffHome />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;