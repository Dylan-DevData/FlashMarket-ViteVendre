// Crée une erreur avec un statut HTTP que le middleware global pourra sérialiser.
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = { httpError };
