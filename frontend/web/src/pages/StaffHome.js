import React, { useState, useEffect, useRef } from 'react';
import { WebSocketClient } from '../api/websocket';

export default function StaffHome() {
  const [assistRequests, setAssistRequests] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!localStorage.getItem('staffAuth')) {
      window.location.href = '/';
      return;
    }

    const ws = new WebSocketClient();
    wsRef.current = ws;

    ws.on('connect', () => {
      setIsLoading(false);
    });

    ws.on('assist_request', (event) => {
      setAssistRequests((prev) => [...prev, event.payload]);
    });

    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, []);

  const handleAccept = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'accept'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  const handleDecline = (requestId) => {
    wsRef.current?.send({
      type: 'assist_response',
      payload: {
        requestId,
        action: 'decline'
      }
    });

    setAssistRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">工作人员中心</h1>
        </div>
      </header>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        {isLoading ? (
          <div className="text-center py-12">加载中...</div>
        ) : assistRequests.length === 0 ? (
          <div className="text-center py-12">
            <h2 className="text-2xl font-semibold text-gray-900">没有待处理请求</h2>
            <p className="mt-1 text-gray-500">系统正在等待新的协助请求...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {assistRequests.map((request) => (
              <div key={request.requestId} className="bg-white rounded-lg shadow-md p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-medium text-gray-900">协助请求</h3>
                  <span
                    className={`px-2 py-1 text-xs font-semibold rounded-full ${
                      request.severity === 'critical'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {request.severity === 'critical' ? '紧急' : '警告'}
                  </span>
                </div>

                <p className="mt-2 text-gray-600">
                  {request.type === 'fall' ? '检测到跌倒' : '异常区域'} 在 {request.zoneId}
                </p>

                <div className="mt-4 flex space-x-3">
                  <button
                    onClick={() => handleAccept(request.requestId)}
                    className="flex-1 bg-green-600 text-white py-2 px-4 rounded-md hover:bg-green-700 transition duration-150"
                  >
                    接受
                  </button>
                  <button
                    onClick={() => handleDecline(request.requestId)}
                    className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-md hover:bg-gray-700 transition duration-150"
                  >
                    拒绝
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
