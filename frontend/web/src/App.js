import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import StaffHome from './pages/StaffHome';
import StaffHomeNTU from './pages/StaffHomeNTU';
import StaffHomeStadium from './pages/StaffHomeStadium';
import Simulation3D from './pages/Simulation3D';
import MapDebug from './pages/MapDebug';

function App() {
  return (
    <Router>
      <div className="App">
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/staff" element={<StaffHome />} />
          <Route path="/staff-ntu" element={<StaffHomeNTU />} />
          <Route path="/staff-stadium" element={<StaffHomeStadium />} />
          <Route path="/sim-3d" element={<Simulation3D />} />
          <Route path="/map-debug" element={<MapDebug />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
