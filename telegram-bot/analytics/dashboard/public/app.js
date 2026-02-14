// Dashboard Application
let currentPeriod = '24h';
let charts = {};
let countdownInterval;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
  initPeriodSelector();
  loadDashboard();
  startAutoRefresh();
});

// Period selector
function initPeriodSelector() {
  const buttons = document.querySelectorAll('.period-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPeriod = btn.dataset.period;
      loadDashboard();
    });
  });
}

// Auto refresh
function startAutoRefresh() {
  let countdown = 30;
  
  countdownInterval = setInterval(() => {
    countdown--;
    document.getElementById('countdown').textContent = countdown;
    
    if (countdown <= 0) {
      loadDashboard();
      countdown = 30;
    }
  }, 1000);
}

// Load all dashboard data
async function loadDashboard() {
  try {
    await Promise.all([
      loadStats(),
      loadDownloadsChart(),
      loadContentTypeChart(),
      loadCommandsChart(),
      loadTopUsers(),
      loadErrors()
    ]);
    
    document.getElementById('lastUpdated').textContent = new Date().toLocaleString();
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

// Load general stats
async function loadStats() {
  const response = await fetch(`/api/stats?period=${currentPeriod}`);
  const data = await response.json();
  
  document.getElementById('totalUsers').textContent = formatNumber(data.totalUsers);
  document.getElementById('activeUsers').textContent = formatNumber(data.activeUsers);
  document.getElementById('totalDownloads').textContent = formatNumber(data.totalDownloads);
  document.getElementById('successRate').textContent = data.successRate + '%';
}

// Load downloads trend chart
async function loadDownloadsChart() {
  const days = currentPeriod === '24h' ? 1 : currentPeriod === '7d' ? 7 : 30;
  const response = await fetch(`/api/downloads/daily?days=${days}`);
  const data = await response.json();
  
  const ctx = document.getElementById('downloadsChart').getContext('2d');
  
  if (charts.downloads) {
    charts.downloads.destroy();
  }
  
  const labels = data.map(d => d.date);
  const downloads = data.map(d => d.downloads);
  const successful = data.map(d => d.successful);
  
  charts.downloads = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Downloads',
          data: downloads,
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96, 165, 250, 0.1)',
          tension: 0.4,
          fill: true
        },
        {
          label: 'Successful',
          data: successful,
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74, 222, 128, 0.1)',
          tension: 0.4,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#e2e8f0' }
        }
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8' },
          grid: { color: '#334155' }
        },
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: '#334155' }
        }
      }
    }
  });
}

// Load content type chart
async function loadContentTypeChart() {
  const response = await fetch(`/api/downloads/by-type?period=${currentPeriod}`);
  const data = await response.json();
  
  const ctx = document.getElementById('contentTypeChart').getContext('2d');
  
  if (charts.contentType) {
    charts.contentType.destroy();
  }
  
  const labels = data.map(d => d._id);
  const values = data.map(d => d.count);
  const colors = ['#60a5fa', '#4ade80', '#f472b6', '#fbbf24'];
  
  charts.contentType = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { 
            color: '#e2e8f0',
            padding: 20
          }
        }
      }
    }
  });
}

// Load commands chart
async function loadCommandsChart() {
  const response = await fetch(`/api/commands?period=${currentPeriod}`);
  const data = await response.json();
  
  const ctx = document.getElementById('commandsChart').getContext('2d');
  
  if (charts.commands) {
    charts.commands.destroy();
  }
  
  const labels = data.map(d => d._id);
  const values = data.map(d => d.count);
  
  charts.commands = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Commands',
        data: values,
        backgroundColor: '#667eea',
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8' },
          grid: { display: false }
        },
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: '#334155' }
        }
      }
    }
  });
}

// Load top users
async function loadTopUsers() {
  const response = await fetch('/api/users/top?limit=10');
  const users = await response.json();
  
  const container = document.getElementById('topUsersList');
  
  if (users.length === 0) {
    container.innerHTML = '<div class="loading">No data available</div>';
    return;
  }
  
  container.innerHTML = users.map(user => `
    <div class="user-item">
      <div class="user-name">${user.username || user.firstName || 'Unknown'}</div>
      <div class="user-stats">
        <span>⬇️ ${user.totalDownloads}</span>
        <span>⌨️ ${user.totalCommands}</span>
      </div>
    </div>
  `).join('');
}

// Load recent errors
async function loadErrors() {
  const response = await fetch('/api/errors?limit=20');
  const errors = await response.json();
  
  const container = document.getElementById('errorsList');
  
  if (errors.length === 0) {
    container.innerHTML = '<div class="loading">No errors found</div>';
    return;
  }
  
  container.innerHTML = errors.map(error => `
    <div class="error-item">
      <div class="error-type">${error.errorType}</div>
      <div class="error-message">${error.message}</div>
      <div class="error-time">${new Date(error.timestamp).toLocaleString()}</div>
    </div>
  `).join('');
}

// Utility functions
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}
